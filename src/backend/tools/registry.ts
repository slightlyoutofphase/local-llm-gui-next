import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, ToolCategory, ToolPolicySummary, ToolSummary } from "../../lib/contracts";
import { ConfigStore } from "../config";
import { DebugLogService } from "../debug";
import type { ApplicationPaths } from "../paths";
import { BUILT_IN_TOOLS } from "./builtins";
import type {
  LocalToolModule,
  ToolManifest,
  ToolContext,
  ToolJsonValue,
  ToolLogEntry,
  ToolObjectSchema,
  ToolPolicy,
  ToolResult,
  ToolSchema,
} from "./types";
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const LOCAL_TOOL_WORKER_ABORT_GRACE_MS = 50;
const LOCAL_TOOL_WORKER_PROCESS_PATH = fileURLToPath(
  new URL("./localToolWorkerProcess.ts", import.meta.url),
);
const UNSUPPORTED_SCHEMA_KEYS = ["$ref", "oneOf", "anyOf", "allOf", "patternProperties"];

/** Fingerprint of a tool's entry-file used to skip unnecessary re-imports. */
interface ToolFileFingerprint {
  /** File modification time in milliseconds since epoch. */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
}

/** Internal registry record binding a validated tool module to its summary and default enabled state. */
interface RegistryEntry {
  defaultEnabled: boolean;
  bundledCode?: string;
  /** Entry-file fingerprint captured at import time for change detection. */
  fingerprint?: ToolFileFingerprint;
  module: LocalToolModule | null;
  summary: ToolSummary;
}

interface ToolContextPayload {
  readonly appDataDir: string;
  readonly callId: string;
  readonly chatId: string;
  readonly modelName?: string;
  readonly tempDir: string;
  readonly workspaceDir?: string;
}

interface ToolWorkerData {
  readonly args: Record<string, unknown>;
  readonly bundledCode: string;
  readonly context: ToolContextPayload;
  readonly entryFile: string;
}

/** Parameters required to execute a tool via {@link LocalToolRegistry.executeTool}. */
export interface ToolExecutionRequest {
  /** Validated arguments matching the tool's input schema. */
  readonly args: Record<string, unknown>;
  /** Identifier of the chat that triggered the tool call. */
  readonly chatId: string;
  /** Optional tool-call identifier for persistence and correlation. */
  readonly callId?: string;
  /** Display name of the model that requested the tool call. */
  readonly modelName?: string;
  /** Abort signal forwarded from the generation request. */
  readonly signal?: AbortSignal;
}

/** An enabled tool's manifest paired with its current summary for the chat-completions pipeline. */
export interface EnabledToolManifestEntry {
  /** The tool's declarative manifest used to build the OpenAI-style function definition. */
  readonly manifest: ToolManifest;
  /** Current registry summary including enabled state and policy. */
  readonly summary: ToolSummary;
}

/**
 * Discovers, validates, and manages local tool modules from both built-in
 * sources and the user's `tools/` directory.
 *
 * The registry enforces the {@link LocalToolModule} contract at load time,
 * merges enabled state from persisted configuration, validates arguments
 * against declared schemas at execution time, and normalises timeouts,
 * aborts, and errors into structured {@link ToolResult} values.
 */
export class LocalToolRegistry {
  private entries = new Map<string, RegistryEntry>();
  private loaded = false;
  private summaries: ToolSummary[] = [];
  private readonly toolEntryRequire = createRequire(import.meta.url);

  /**
   * @param applicationPaths - Resolved application directory paths.
   * @param configStore - Persisted configuration store for tool enabled states.
   * @param debugLogService - Debug log service for tool lifecycle and execution logging.
   */
  public constructor(
    private readonly applicationPaths: ApplicationPaths,
    private readonly configStore: ConfigStore,
    private readonly debugLogService: DebugLogService,
  ) {}

  /**
   * Returns all discovered tool summaries, performing an initial scan if
   * the registry has not yet been loaded.
   *
   * @returns Cloned array of every tool summary (both loaded and rejected).
   */
  public async listTools(): Promise<ToolSummary[]> {
    if (!this.loaded) {
      await this.refreshTools();
    } else {
      this.applyConfig(await this.configStore.getConfig());
    }

    return this.summaries.map(cloneToolSummary);
  }

  /**
   * Performs a fresh scan of built-in and user-authored tool directories,
   * re-importing and re-validating every tool module.
   *
   * @returns Cloned array of every tool summary after the refresh.
   */
  public async refreshTools(): Promise<ToolSummary[]> {
    const config = await this.configStore.getConfig();
    const nextEntries = new Map<string, RegistryEntry>();
    const nextSummaries: ToolSummary[] = [];

    for (const builtInTool of BUILT_IN_TOOLS) {
      const validation = validateToolModule(builtInTool, "built-in");

      if (validation.summary.loadStatus === "loaded" && validation.module) {
        nextEntries.set(validation.summary.name, {
          defaultEnabled: validation.defaultEnabled,
          module: validation.module,
          summary: validation.summary,
        });
      }

      nextSummaries.push(validation.summary);
    }

    try {
      const toolDirectories = await readdir(this.applicationPaths.toolsDir, {
        withFileTypes: true,
      });

      for (const toolDirectory of toolDirectories) {
        if (!toolDirectory.isDirectory()) {
          continue;
        }

        const folderName = toolDirectory.name;
        const folderPath = path.join(this.applicationPaths.toolsDir, folderName);
        const entryFile = resolveLocalToolEntryFile(folderPath);

        if (entryFile instanceof Error) {
          nextSummaries.push(createRejectedSummary(folderName, folderPath, entryFile.message));
          continue;
        }

        try {
          const fileStats = await stat(entryFile);
          const currentFingerprint: ToolFileFingerprint = {
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
          };
          const existingEntry = this.entries.get(folderName);
          const fingerprintUnchanged =
            existingEntry?.fingerprint &&
            existingEntry.fingerprint.mtimeMs === currentFingerprint.mtimeMs &&
            existingEntry.fingerprint.size === currentFingerprint.size;

          let validation: ReturnType<typeof validateToolModule>;
          let bundledCode: string | undefined;

          if (fingerprintUnchanged && existingEntry.module && existingEntry.bundledCode) {
            validation = {
              defaultEnabled: existingEntry.defaultEnabled,
              module: existingEntry.module,
              summary: existingEntry.summary,
            };
            bundledCode = existingEntry.bundledCode;
          } else {
            const importedModule = await this.loadLocalToolModule(entryFile);

            bundledCode = importedModule.bundledCode;
            validation = validateToolModule(
              importedModule.module.default,
              "local",
              entryFile,
              folderName,
            );
          }

          if (nextEntries.has(validation.summary.name)) {
            nextSummaries.push(
              createRejectedSummary(
                validation.summary.name,
                entryFile,
                `Duplicate tool name: ${validation.summary.name}.`,
              ),
            );
            continue;
          }

          if (validation.summary.loadStatus === "loaded" && validation.module) {
            nextEntries.set(validation.summary.name, {
              defaultEnabled: validation.defaultEnabled,
              bundledCode,
              fingerprint: currentFingerprint,
              module: validation.module,
              summary: validation.summary,
            });
          }

          nextSummaries.push(validation.summary);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to import the tool module.";
          nextSummaries.push(createRejectedSummary(folderName, entryFile, message));
          this.debugLogService.serverLog(`Tool import failed for ${folderName}: ${message}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to scan the tools directory.";
      this.debugLogService.serverLog(`Tool scan failed: ${message}`);
    }

    this.entries = nextEntries;
    this.summaries = nextSummaries.sort(compareToolSummaries);
    this.loaded = true;
    this.applyConfig(config);
    this.debugLogService.serverLog(
      `Tool registry refreshed with ${this.summaries.length} discovered entries.`,
    );

    return this.summaries.map(cloneToolSummary);
  }

  /**
   * Returns the manifests and summaries of all currently enabled and
   * successfully loaded tools, suitable for injection into the
   * `tools` field of a `POST /v1/chat/completions` request.
   *
   * @returns Array of enabled tool manifest entries.
   */
  public async listEnabledToolManifests(): Promise<EnabledToolManifestEntry[]> {
    if (!this.loaded) {
      await this.refreshTools();
    } else {
      this.applyConfig(await this.configStore.getConfig());
    }

    return [...this.entries.values()]
      .filter((entry) => entry.summary.loadStatus === "loaded" && entry.summary.enabled)
      .map((entry) => ({
        manifest: entry.module!.manifest,
        summary: cloneToolSummary(entry.summary),
      }));
  }

  /**
   * Executes a tool by name with the provided request parameters.
   *
   * The method validates that the tool exists, is enabled, and that the
   * supplied arguments conform to the declared input schema before
   * invoking the tool's `run()` method. Timeouts, aborts, and thrown
   * exceptions are normalised into structured {@link ToolResult} failures.
   *
   * @param toolName - Canonical name of the tool to execute.
   * @param request - Execution parameters including arguments, chat ID, and abort signal.
   * @returns A {@link ToolResult} representing success or structured failure.
   */
  public async executeTool(toolName: string, request: ToolExecutionRequest): Promise<ToolResult> {
    if (!this.loaded) {
      await this.refreshTools();
    }

    const config = await this.configStore.getConfig();
    this.applyConfig(config);

    const entry = this.entries.get(toolName);

    if (!entry || !entry.module || entry.summary.loadStatus !== "loaded") {
      return createToolFailure("tool_not_found", `Tool not found: ${toolName}.`);
    }

    if (!entry.summary.enabled) {
      return createToolFailure("tool_disabled", `Tool is disabled: ${toolName}.`);
    }

    const validationError = validateArguments(
      entry.module.manifest.inputSchema,
      request.args,
      "$input",
    );

    if (validationError) {
      return createToolFailure("invalid_arguments", validationError);
    }

    if (request.signal?.aborted) {
      return createToolFailure("aborted", `Tool execution was aborted: ${toolName}.`);
    }

    if (entry.summary.source === "local") {
      return await this.executeLocalToolInWorker(toolName, entry, request);
    }

    return await this.executeToolInProcess(toolName, entry, request);
  }

  private async executeToolInProcess(
    toolName: string,
    entry: RegistryEntry,
    request: ToolExecutionRequest,
  ): Promise<ToolResult> {
    if (!entry.module) {
      return createToolFailure("tool_not_found", `Tool not found: ${toolName}.`);
    }

    const executionAbortController = new AbortController();
    const timeoutMs = entry.summary.policy.timeoutMs;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const abortListener = (): void => {
      executionAbortController.abort();
    };

    if (request.signal) {
      if (request.signal.aborted) {
        executionAbortController.abort();
      } else {
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        executionAbortController.abort();
      }, timeoutMs);
    }

    const context = this.buildToolContext(toolName, request, executionAbortController.signal);

    try {
      const result = await entry.module.run(request.args, context);

      if (!isValidToolResult(result)) {
        return createToolFailure(
          "invalid_result",
          `Tool ${toolName} returned an invalid result shape.`,
        );
      }

      return result;
    } catch (error) {
      if (timedOut) {
        return createToolFailure("timeout", `Tool timed out after ${timeoutMs}ms.`);
      }

      if (executionAbortController.signal.aborted) {
        return createToolFailure("aborted", `Tool execution was aborted: ${toolName}.`);
      }

      const message =
        error instanceof Error ? error.message : `Tool execution failed: ${toolName}.`;

      return createToolFailure("execution_failed", message);
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", abortListener);
      }

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async executeLocalToolInWorker(
    toolName: string,
    entry: RegistryEntry,
    request: ToolExecutionRequest,
  ): Promise<ToolResult> {
    if (!entry.bundledCode || !entry.summary.sourcePath) {
      return createToolFailure(
        "execution_failed",
        `Tool worker payload is unavailable for ${toolName}. Refresh the tool registry and try again.`,
      );
    }

    const bundledCode = entry.bundledCode;
    const entryFile = entry.summary.sourcePath;

    let childProcess: ChildProcessWithoutNullStreams;

    try {
      const command = this.getLocalToolWorkerLaunchCommand();

      childProcess = spawn(command[0], command.slice(1), {
        cwd: this.applicationPaths.workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return createToolFailure(
        "execution_failed",
        error instanceof Error ? error.message : `Tool execution failed: ${toolName}.`,
      );
    }

    return await new Promise<ToolResult>((resolve) => {
      let cancellationReason: "aborted" | "timeout" | null = null;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let killHandle: ReturnType<typeof setTimeout> | null = null;
      let stderrOutput = "";
      let stdoutBuffer = "";
      const timeoutMs = entry.summary.policy.timeoutMs;
      const abortListener = (): void => {
        beginCancellation("aborted");
      };
      const processBufferedLine = (line: string): void => {
        const trimmedLine = line.trim();

        if (trimmedLine.length === 0) {
          return;
        }

        let message: unknown;

        try {
          message = JSON.parse(trimmedLine) as unknown;
        } catch {
          stderrOutput = `${stderrOutput}${trimmedLine}\n`;
          return;
        }

        if (!isObjectRecord(message) || typeof message["type"] !== "string") {
          return;
        }

        if (message["type"] === "log") {
          const logEntry = normalizeWorkerLogEntry(message["entry"]);

          if (logEntry) {
            this.debugLogService.serverLog(
              `[tool:${toolName}] ${logEntry.level}: ${logEntry.message}`,
            );
          }

          return;
        }

        if (cancellationReason) {
          return;
        }

        if (message["type"] === "error") {
          const errorPayload = normalizeWorkerError(message);

          finish(
            createToolFailure(
              errorPayload?.phase === "result" ? "invalid_result" : "execution_failed",
              errorPayload?.phase === "result"
                ? `Tool ${toolName} returned a non-serializable result.`
                : (errorPayload?.message ?? `Tool execution failed: ${toolName}.`),
            ),
          );
          return;
        }

        if (message["type"] === "result") {
          const result = message["result"];

          if (!isValidToolResult(result)) {
            finish(
              createToolFailure(
                "invalid_result",
                `Tool ${toolName} returned an invalid result shape.`,
              ),
            );
            return;
          }

          finish(result);
        }
      };
      const cleanup = (): void => {
        childProcess.removeAllListeners();
        childProcess.stdin.removeAllListeners();
        childProcess.stdout.removeAllListeners();
        childProcess.stderr.removeAllListeners();

        if (request.signal) {
          request.signal.removeEventListener("abort", abortListener);
        }

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        if (killHandle) {
          clearTimeout(killHandle);
        }
      };
      const resolveCancellationFailure = (): ToolResult =>
        cancellationReason === "timeout"
          ? createToolFailure("timeout", `Tool timed out after ${timeoutMs}ms.`)
          : createToolFailure("aborted", `Tool execution was aborted: ${toolName}.`);
      const finish = (result: ToolResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(result);
      };
      const beginCancellation = (reason: "aborted" | "timeout"): void => {
        if (settled || cancellationReason) {
          return;
        }

        cancellationReason = reason;

        void this.forceKillLocalToolProcess(childProcess);

        killHandle = setTimeout(() => {
          finish(resolveCancellationFailure());
        }, LOCAL_TOOL_WORKER_ABORT_GRACE_MS);
      };

      if (request.signal) {
        request.signal.addEventListener("abort", abortListener, { once: true });
      }

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          beginCancellation("timeout");
        }, timeoutMs);
      }

      childProcess.stdin.once("error", (error) => {
        if (cancellationReason) {
          finish(resolveCancellationFailure());
          return;
        }

        finish(
          createToolFailure(
            "execution_failed",
            error instanceof Error ? error.message : `Tool execution failed: ${toolName}.`,
          ),
        );
      });
      childProcess.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;

        while (stdoutBuffer.includes("\n")) {
          const newlineIndex = stdoutBuffer.indexOf("\n");
          const line = stdoutBuffer.slice(0, newlineIndex);

          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          processBufferedLine(line);
        }
      });
      childProcess.stderr.on("data", (chunk: Buffer | string) => {
        stderrOutput += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      });
      childProcess.once("error", (error) => {
        if (cancellationReason) {
          finish(resolveCancellationFailure());
          return;
        }

        finish(
          createToolFailure(
            "execution_failed",
            error instanceof Error ? error.message : `Tool execution failed: ${toolName}.`,
          ),
        );
      });
      childProcess.once("exit", (code) => {
        if (settled) {
          return;
        }

        if (stdoutBuffer.trim().length > 0) {
          processBufferedLine(stdoutBuffer);
          stdoutBuffer = "";
        }

        if (cancellationReason) {
          finish(resolveCancellationFailure());
          return;
        }

        finish(
          createToolFailure(
            "execution_failed",
            buildLocalToolExitMessage(toolName, code, stderrOutput),
          ),
        );
      });

      try {
        childProcess.stdin.end(
          JSON.stringify({
            args: request.args,
            bundledCode,
            context: this.buildToolContextPayload(request),
            entryFile,
          } satisfies ToolWorkerData),
        );
      } catch (error) {
        finish(
          createToolFailure(
            "execution_failed",
            error instanceof Error ? error.message : `Tool execution failed: ${toolName}.`,
          ),
        );
      }
    });
  }

  private getLocalToolWorkerLaunchCommand(): readonly [string, ...string[]] {
    if (existsSync(LOCAL_TOOL_WORKER_PROCESS_PATH)) {
      return [process.execPath, LOCAL_TOOL_WORKER_PROCESS_PATH];
    }

    return [process.execPath, "--run-local-tool-worker"];
  }

  private async forceKillLocalToolProcess(
    childProcess: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      return;
    }

    if (process.platform === "win32" && typeof childProcess.pid === "number") {
      try {
        await Bun.spawn(["taskkill", "/T", "/F", "/PID", String(childProcess.pid)], {
          stderr: "ignore",
          stdout: "ignore",
        }).exited;
        return;
      } catch {
        // Fall through to child_process.kill if taskkill is unavailable.
      }
    }

    childProcess.kill("SIGKILL");
  }

  private buildToolContext(
    toolName: string,
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): ToolContext {
    const contextPayload = this.buildToolContextPayload(request);

    return {
      ...contextPayload,
      signal,
      log: (entryToLog) => {
        this.debugLogService.serverLog(
          `[tool:${toolName}] ${entryToLog.level}: ${entryToLog.message}`,
        );
      },
    };
  }

  private buildToolContextPayload(request: ToolExecutionRequest): ToolContextPayload {
    return {
      appDataDir: this.applicationPaths.userDataDir,
      callId: request.callId ?? crypto.randomUUID(),
      chatId: request.chatId,
      tempDir: this.applicationPaths.tempDir,
      workspaceDir: this.applicationPaths.workspaceRoot,
      ...(request.modelName ? { modelName: request.modelName } : {}),
    };
  }

  /**
   * Synchronises each tool summary's enabled state with the persisted
   * configuration, applying defaults for tools not yet recorded.
   *
   * @param config - Current application configuration snapshot.
   */
  private applyConfig(config: AppConfig): void {
    this.summaries = this.summaries.map((summary) => {
      const entry = this.entries.get(summary.name);
      const enabled =
        summary.loadStatus === "loaded"
          ? (config.toolEnabledStates[summary.name] ?? entry?.defaultEnabled ?? true)
          : false;

      const nextSummary = {
        ...summary,
        enabled,
      };

      if (entry) {
        entry.summary = nextSummary;
      }

      return nextSummary;
    });
  }

  private async loadLocalToolModule(
    entryFile: string,
  ): Promise<{ bundledCode: string; module: { default?: unknown } }> {
    const bundledCode = await bundleLocalToolEntry(entryFile);
    const localModule = { exports: {} as unknown };
    const localRequire = this.toolEntryRequire;
    const evaluatorSource = isBunCommonJsWrapper(bundledCode)
      ? `${bundledCode}(exports, require, module, __filename, __dirname);`
      : bundledCode;
    const evaluator = new Function(
      "require",
      "module",
      "exports",
      "__dirname",
      "__filename",
      evaluatorSource,
    ) as (
      require: NodeJS.Require,
      moduleRecord: { exports: unknown },
      exports: unknown,
      dirname: string,
      filename: string,
    ) => void;

    evaluator(localRequire, localModule, localModule.exports, path.dirname(entryFile), entryFile);

    if (isObjectRecord(localModule.exports) && "default" in localModule.exports) {
      return {
        bundledCode,
        module: localModule.exports as { default?: unknown },
      };
    }

    return {
      bundledCode,
      module: { default: localModule.exports },
    };
  }
}

async function bundleLocalToolEntry(entryFile: string): Promise<string> {
  if (typeof Bun.build !== "function") {
    return await readFile(entryFile, "utf8");
  }

  const buildResult = await Bun.build({
    bundle: true,
    entrypoints: [entryFile],
    format: "cjs",
    minify: false,
    sourcemap: "none",
    target: "bun",
    write: false,
  } as Parameters<typeof Bun.build>[0]);

  if (!buildResult.success) {
    const failureText = buildResult.logs
      .map((log) => log.message)
      .filter((message) => message.length > 0)
      .join("; ");

    throw new Error(
      failureText.length > 0 ? failureText : "Failed to bundle the tool entry module.",
    );
  }

  const bundledArtifact = buildResult.outputs[0];

  if (!bundledArtifact) {
    throw new Error("Bundling the tool entry did not produce an output artifact.");
  }

  return await bundledArtifact.text();
}

function isBunCommonJsWrapper(code: string): boolean {
  return /^\s*(?:\/\/.*\r?\n)*\(function\s*\(/.test(code);
}

/**
 * Resolves the canonical entry file (`tool.ts` or `tool.js`) inside a
 * tool folder, returning an error if none or both are present.
 *
 * @param folderPath - Absolute path to the tool folder.
 * @returns Absolute path to the entry file, or an `Error` describing the problem.
 */
function resolveLocalToolEntryFile(folderPath: string): string | Error {
  const tsEntryPath = path.join(folderPath, "tool.ts");
  const jsEntryPath = path.join(folderPath, "tool.js");
  const hasTsEntry = existsSync(tsEntryPath);
  const hasJsEntry = existsSync(jsEntryPath);

  if (hasTsEntry && hasJsEntry) {
    return new Error(
      "Each tool folder may contain only one entry file. Remove either tool.ts or tool.js.",
    );
  }

  if (hasTsEntry) {
    return tsEntryPath;
  }

  if (hasJsEntry) {
    return jsEntryPath;
  }

  return new Error("Missing tool entry file. Expected tool.ts.");
}

/**
 * Validates a candidate default export against the {@link LocalToolModule}
 * contract and returns the validated module alongside its summary.
 *
 * @param candidate - The raw default export from a tool module file.
 * @param source - Whether the tool is `"built-in"` or `"local"` (user-authored).
 * @param sourcePath - Absolute path to the tool entry file, if available.
 * @param folderName - Containing folder name, used to enforce the name match rule.
 * @returns An object with the validated module (or `null`) and a summary.
 */
function validateToolModule(
  candidate: unknown,
  source: "built-in" | "local",
  sourcePath?: string,
  folderName?: string,
): { defaultEnabled: boolean; module: LocalToolModule | null; summary: ToolSummary } {
  if (!isObjectRecord(candidate)) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        folderName ?? "unknown_tool",
        sourcePath,
        "Default export must be an object.",
      ),
    };
  }

  if (candidate["apiVersion"] !== 1) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        folderName ?? "unknown_tool",
        sourcePath,
        "Invalid apiVersion. Expected 1.",
      ),
    };
  }

  if (candidate["kind"] !== "local-tool") {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        folderName ?? "unknown_tool",
        sourcePath,
        'Invalid kind. Expected "local-tool".',
      ),
    };
  }

  if (typeof candidate["run"] !== "function") {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        folderName ?? "unknown_tool",
        sourcePath,
        "Tool module must export a run(...) function.",
      ),
    };
  }

  const manifest = candidate["manifest"];

  if (!isObjectRecord(manifest)) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        folderName ?? "unknown_tool",
        sourcePath,
        "Tool manifest is missing or invalid.",
      ),
    };
  }

  const manifestName =
    typeof manifest["name"] === "string" ? manifest["name"] : (folderName ?? "unknown_tool");

  if (!TOOL_NAME_PATTERN.test(manifestName)) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        manifestName,
        sourcePath,
        "Tool manifest name must match ^[a-z][a-z0-9_]{0,63}$.",
      ),
    };
  }

  if (source === "local" && folderName && manifestName !== folderName) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        manifestName,
        sourcePath,
        "Tool folder name must match manifest.name exactly.",
      ),
    };
  }

  if (typeof manifest["description"] !== "string" || manifest["description"].trim().length === 0) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(
        manifestName,
        sourcePath,
        "Tool description must be a non-empty string.",
      ),
    };
  }

  const inputSchema = manifest["inputSchema"];
  const inputSchemaError = validateSchema(inputSchema, true, `${manifestName}.inputSchema`);

  if (inputSchemaError) {
    return {
      defaultEnabled: false,
      module: null,
      summary: createRejectedSummary(manifestName, sourcePath, inputSchemaError),
    };
  }

  const outputSchema = manifest["outputSchema"];

  if (typeof outputSchema !== "undefined") {
    const outputSchemaError = validateSchema(outputSchema, false, `${manifestName}.outputSchema`);

    if (outputSchemaError) {
      return {
        defaultEnabled: false,
        module: null,
        summary: createRejectedSummary(manifestName, sourcePath, outputSchemaError),
      };
    }
  }

  const normalizedPolicy = normalizePolicy(
    isObjectRecord(manifest["policy"]) ? (manifest["policy"] as ToolPolicy) : undefined,
  );
  const validatedModule: LocalToolModule<Record<string, unknown>, ToolJsonValue> = {
    apiVersion: 1,
    kind: "local-tool",
    manifest: {
      description: manifest["description"] as string,
      inputSchema: inputSchema as ToolObjectSchema,
      name: manifestName,
      ...(typeof manifest["displayName"] === "string" && manifest["displayName"].trim().length > 0
        ? { displayName: manifest["displayName"] }
        : {}),
      ...(typeof outputSchema !== "undefined" ? { outputSchema: outputSchema as ToolSchema } : {}),
      ...(isObjectRecord(manifest["policy"]) ? { policy: manifest["policy"] as ToolPolicy } : {}),
    },
    run: candidate["run"] as LocalToolModule<Record<string, unknown>, ToolJsonValue>["run"],
  };
  const summary: ToolSummary = {
    description: manifest["description"] as string,
    enabled: normalizedPolicy.enabledByDefault,
    id: manifestName,
    loadStatus: "loaded",
    name: manifestName,
    policy: {
      allowParallel: normalizedPolicy.allowParallel,
      category: normalizedPolicy.category,
      dangerous: normalizedPolicy.dangerous,
      requiresConfirmation: normalizedPolicy.requiresConfirmation,
    },
    source,
  };

  if (typeof normalizedPolicy.timeoutMs === "number") {
    summary.policy.timeoutMs = normalizedPolicy.timeoutMs;
  }

  if (typeof manifest["displayName"] === "string" && manifest["displayName"].trim().length > 0) {
    summary.displayName = manifest["displayName"];
  }

  if (sourcePath) {
    summary.sourcePath = sourcePath;
  }

  return {
    defaultEnabled: normalizedPolicy.enabledByDefault,
    module: validatedModule,
    summary,
  };
}

/**
 * Normalises a raw {@link ToolPolicy} (which may be partially defined) into
 * a complete policy summary with defaults applied.
 *
 * @param policy - Optional raw policy from the tool manifest.
 * @returns A fully resolved policy summary with `enabledByDefault`.
 */
function normalizePolicy(
  policy: ToolPolicy | undefined,
): ToolPolicySummary & { enabledByDefault: boolean } {
  const category = isToolCategory(policy?.category) ? policy.category : "custom";
  const timeoutMs =
    typeof policy?.timeoutMs === "number" &&
    Number.isFinite(policy.timeoutMs) &&
    policy.timeoutMs > 0
      ? Math.floor(policy.timeoutMs)
      : DEFAULT_TOOL_TIMEOUT_MS;

  return {
    allowParallel: policy?.allowParallel === true,
    category,
    dangerous: policy?.dangerous === true,
    enabledByDefault: policy?.enabledByDefault !== false,
    requiresConfirmation: policy?.requiresConfirmation === true,
    timeoutMs,
  };
}

/**
 * Recursively validates a JSON schema object against the supported v1
 * subset, rejecting unsupported keywords such as `$ref`.
 *
 * @param schema - Raw schema value to validate.
 * @param requireRootObject - When `true`, the schema must be an object type.
 * @param pathLabel - Dot-path label used in error messages.
 * @returns `null` if valid, or a human-readable error string.
 */
function validateSchema(
  schema: unknown,
  requireRootObject: boolean,
  pathLabel: string,
): string | null {
  if (!isObjectRecord(schema)) {
    return `${pathLabel} must be a schema object.`;
  }

  for (const unsupportedKey of UNSUPPORTED_SCHEMA_KEYS) {
    if (unsupportedKey in schema) {
      return `${pathLabel} uses unsupported schema keyword ${unsupportedKey}.`;
    }
  }

  const schemaType = schema["type"];

  if (
    schemaType !== "string" &&
    schemaType !== "number" &&
    schemaType !== "integer" &&
    schemaType !== "boolean" &&
    schemaType !== "array" &&
    schemaType !== "object"
  ) {
    return `${pathLabel} has an unsupported or missing schema type.`;
  }

  if (requireRootObject && schemaType !== "object") {
    return `${pathLabel} must use an object schema at the root.`;
  }

  if (schemaType === "object") {
    if (requireRootObject && schema["additionalProperties"] !== false) {
      return `${pathLabel} must set additionalProperties to false at the root.`;
    }

    const properties = schema["properties"];

    if (!isObjectRecord(properties)) {
      return `${pathLabel}.properties must be an object.`;
    }

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const nestedError = validateSchema(
        propertySchema,
        false,
        `${pathLabel}.properties.${propertyName}`,
      );

      if (nestedError) {
        return nestedError;
      }
    }
  }

  if (schemaType === "array") {
    const items = schema["items"];

    if (typeof items === "undefined") {
      return `${pathLabel}.items is required for array schemas.`;
    }

    return validateSchema(items, false, `${pathLabel}.items`);
  }

  return null;
}

/**
 * Entry point for validating tool call arguments against the root input schema.
 *
 * @param schema - The tool's root object schema.
 * @param value - The parsed arguments value to validate.
 * @param pathLabel - Label prefix for error messages.
 * @returns `null` if valid, or a human-readable error string.
 */
function validateArguments(
  schema: ToolObjectSchema,
  value: unknown,
  pathLabel: string,
): string | null {
  return validateValueAgainstSchema(schema, value, pathLabel);
}

/**
 * Recursively validates a single value against its declared schema.
 *
 * @param schema - Expected schema for the value.
 * @param value - Runtime value to validate.
 * @param pathLabel - Dot-path label for error messages.
 * @returns `null` if valid, or a human-readable error string.
 */
function validateValueAgainstSchema(
  schema: ToolSchema,
  value: unknown,
  pathLabel: string,
): string | null {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return `${pathLabel} must be a string.`;
      }

      if (schema.enum && !schema.enum.includes(value)) {
        return `${pathLabel} must be one of: ${schema.enum.join(", ")}.`;
      }

      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        return `${pathLabel} must have length >= ${schema.minLength}.`;
      }

      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        return `${pathLabel} must have length <= ${schema.maxLength}.`;
      }

      return null;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `${pathLabel} must be a number.`;
      }

      if (typeof schema.minimum === "number" && value < schema.minimum) {
        return `${pathLabel} must be >= ${schema.minimum}.`;
      }

      if (typeof schema.maximum === "number" && value > schema.maximum) {
        return `${pathLabel} must be <= ${schema.maximum}.`;
      }

      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${pathLabel} must be an integer.`;
      }

      if (typeof schema.minimum === "number" && value < schema.minimum) {
        return `${pathLabel} must be >= ${schema.minimum}.`;
      }

      if (typeof schema.maximum === "number" && value > schema.maximum) {
        return `${pathLabel} must be <= ${schema.maximum}.`;
      }

      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${pathLabel} must be a boolean.`;
    case "array":
      if (!Array.isArray(value)) {
        return `${pathLabel} must be an array.`;
      }

      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        return `${pathLabel} must contain at least ${schema.minItems} items.`;
      }

      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        return `${pathLabel} must contain at most ${schema.maxItems} items.`;
      }

      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateValueAgainstSchema(
          schema.items,
          value[index],
          `${pathLabel}[${index}]`,
        );

        if (nestedError) {
          return nestedError;
        }
      }

      return null;
    case "object": {
      if (!isObjectRecord(value) || Array.isArray(value)) {
        return `${pathLabel} must be an object.`;
      }

      const requiredProperties = schema.required ?? [];

      for (const requiredProperty of requiredProperties) {
        if (!(requiredProperty in value)) {
          return `${pathLabel}.${requiredProperty} is required.`;
        }
      }

      if (schema.additionalProperties === false) {
        const unknownKey = Object.keys(value).find((key) => !(key in schema.properties));

        if (unknownKey) {
          return `${pathLabel}.${unknownKey} is not allowed.`;
        }
      }

      for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
        if (!(propertyName in value)) {
          continue;
        }

        const nestedError = validateValueAgainstSchema(
          propertySchema,
          value[propertyName],
          `${pathLabel}.${propertyName}`,
        );

        if (nestedError) {
          return nestedError;
        }
      }

      return null;
    }
  }
}

/**
 * Type guard that checks whether a value conforms to the {@link ToolResult}
 * discriminated union shape.
 *
 * @param value - Value returned by a tool's `run()` method.
 * @returns `true` if the value is a valid success or failure result.
 */
function isValidToolResult(value: unknown): value is ToolResult {
  if (!isObjectRecord(value) || typeof value["ok"] !== "boolean") {
    return false;
  }

  if (value["ok"] === true) {
    if (typeof value["content"] !== "string") {
      return false;
    }

    const data = value["data"];

    return typeof data === "undefined" || isToolJsonValue(data);
  }

  const error = value["error"];

  if (
    !isObjectRecord(error) ||
    typeof error["code"] !== "string" ||
    typeof error["message"] !== "string"
  ) {
    return false;
  }

  const errorData = error["data"];

  return typeof errorData === "undefined" || isToolJsonValue(errorData);
}

/**
 * Recursively checks that a value is a valid {@link ToolJsonValue}.
 *
 * @param value - Arbitrary runtime value.
 * @returns `true` if the value is a primitive, array, or plain object of JSON values.
 */
function isToolJsonValue(value: unknown): value is ToolJsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isToolJsonValue(item));
  }

  if (!isObjectRecord(value)) {
    return false;
  }

  return Object.values(value).every((nestedValue) => isToolJsonValue(nestedValue));
}

/** Shallow type guard for plain objects (non-null, typeof `"object"`). */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Type guard for valid {@link ToolCategory} string literals. */
function isToolCategory(value: unknown): value is ToolCategory {
  return (
    value === "filesystem" ||
    value === "network" ||
    value === "system" ||
    value === "data" ||
    value === "custom"
  );
}

/**
 * Constructs a summary record for a tool that failed validation.
 *
 * @param toolName - Canonical tool name (or folder name).
 * @param sourcePath - Absolute path to the tool entry file.
 * @param error - Human-readable error message explaining the rejection.
 * @returns A {@link ToolSummary} with `loadStatus: "rejected"`.
 */
function createRejectedSummary(
  toolName: string,
  sourcePath: string | undefined,
  error: string,
): ToolSummary {
  const summary: ToolSummary = {
    description: "",
    enabled: false,
    error,
    id: toolName,
    loadStatus: "rejected",
    name: toolName,
    policy: {
      allowParallel: false,
      category: "custom",
      dangerous: false,
      requiresConfirmation: false,
    },
    source: "local",
  };

  if (sourcePath) {
    summary.sourcePath = sourcePath;
  }

  return summary;
}

/**
 * Creates a structured failure {@link ToolResult}.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable error message.
 * @returns A failure result suitable for returning to the chat-completions pipeline.
 */
function createToolFailure(code: string, message: string): ToolResult {
  return {
    error: {
      code,
      message,
    },
    ok: false,
  };
}

function normalizeWorkerError(
  value: unknown,
): { readonly message: string; readonly name: string; readonly phase: string } | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (!isObjectRecord(value["error"])) {
    return null;
  }

  if (
    typeof value["error"]["message"] !== "string" ||
    typeof value["error"]["name"] !== "string" ||
    typeof value["phase"] !== "string"
  ) {
    return null;
  }

  return {
    message: value["error"]["message"],
    name: value["error"]["name"],
    phase: value["phase"],
  };
}

function normalizeWorkerLogEntry(value: unknown): ToolLogEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const level = value["level"];
  const message = value["message"];

  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    return null;
  }

  if (typeof message !== "string") {
    return null;
  }

  return {
    level,
    message,
  };
}

function buildLocalToolExitMessage(
  toolName: string,
  exitCode: number | null,
  stderrOutput: string,
): string {
  const normalizedStderr = stderrOutput.trim();
  const exitLabel = exitCode === null ? "unknown" : String(exitCode);

  if (normalizedStderr.length > 0) {
    return `Tool worker exited unexpectedly with code ${exitLabel} for ${toolName}: ${normalizedStderr}`;
  }

  return `Tool worker exited unexpectedly with code ${exitLabel} for ${toolName}.`;
}

/**
 * Comparator for sorting tool summaries: built-in tools first, then
 * alphabetically by display name.
 *
 * @param left - First summary.
 * @param right - Second summary.
 * @returns Negative, zero, or positive ordering value.
 */
function compareToolSummaries(left: ToolSummary, right: ToolSummary): number {
  if (left.source !== right.source) {
    return left.source.localeCompare(right.source);
  }

  return (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name);
}

/**
 * Shallow-clones a {@link ToolSummary} to prevent external mutation of
 * the registry's internal state.
 *
 * @param summary - Summary to clone.
 * @returns A new summary object with a cloned policy sub-object.
 */
function cloneToolSummary(summary: ToolSummary): ToolSummary {
  return {
    ...summary,
    policy: {
      ...summary.policy,
    },
  };
}
