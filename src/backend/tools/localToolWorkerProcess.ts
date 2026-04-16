import { createRequire } from "node:module";
import path from "node:path";
import type { ToolContext } from "./types";

interface ToolContextPayload {
  readonly appDataDir: string;
  readonly callId: string;
  readonly chatId: string;
  readonly modelName?: string;
  readonly tempDir: string;
  readonly workspaceDir?: string;
}

interface ToolWorkerPayload {
  readonly args: Record<string, unknown>;
  readonly bundledCode: string;
  readonly context: ToolContextPayload;
  readonly entryFile: string;
}

type RunnableToolModule = {
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBunCommonJsWrapper(code: string): boolean {
  return /^\s*(?:\/\/.*\r?\n)*\(function\s*\(/.test(code);
}

function evaluateBundledToolModule(entryFile: string, bundledCode: string): unknown {
  const localModule = { exports: {} as unknown };
  const localRequire = createRequire(entryFile);
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
    return localModule.exports["default"];
  }

  return localModule.exports;
}

async function readWorkerPayload(): Promise<ToolWorkerPayload> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const payloadText = Buffer.concat(chunks).toString("utf8").trim();

  if (payloadText.length === 0) {
    throw new Error("Missing tool worker payload.");
  }

  const payload = JSON.parse(payloadText) as unknown;

  if (!isObjectRecord(payload)) {
    throw new Error("Invalid tool worker payload.");
  }

  if (
    typeof payload["bundledCode"] !== "string" ||
    typeof payload["entryFile"] !== "string" ||
    !isObjectRecord(payload["context"]) ||
    !isObjectRecord(payload["args"])
  ) {
    throw new Error("Incomplete tool worker payload.");
  }

  const context = payload["context"];

  if (
    typeof context["appDataDir"] !== "string" ||
    typeof context["callId"] !== "string" ||
    typeof context["chatId"] !== "string" ||
    typeof context["tempDir"] !== "string"
  ) {
    throw new Error("Invalid tool worker context payload.");
  }

  return {
    args: payload["args"],
    bundledCode: payload["bundledCode"],
    context: {
      appDataDir: context["appDataDir"],
      callId: context["callId"],
      chatId: context["chatId"],
      tempDir: context["tempDir"],
      ...(typeof context["modelName"] === "string" ? { modelName: context["modelName"] } : {}),
      ...(typeof context["workspaceDir"] === "string"
        ? { workspaceDir: context["workspaceDir"] }
        : {}),
    },
    entryFile: payload["entryFile"],
  };
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function createSerializedError(error: unknown): {
  readonly message: string;
  readonly name: string;
} {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}

export async function runLocalToolWorkerProcess(): Promise<void> {
  const payload = await readWorkerPayload();
  const abortController = new AbortController();

  for (const signalName of ["SIGINT", "SIGTERM"]) {
    process.on(signalName, () => {
      abortController.abort();
    });
  }

  const toolModule = evaluateBundledToolModule(payload.entryFile, payload.bundledCode);

  if (!isObjectRecord(toolModule) || typeof toolModule["run"] !== "function") {
    throw new Error("Tool worker loaded an invalid tool module.");
  }

  const runnableToolModule = toolModule as RunnableToolModule;

  const context: ToolContext = {
    ...payload.context,
    signal: abortController.signal,
    log: (entry) => {
      writeMessage({
        entry,
        type: "log",
      });
    },
  };
  const result = await runnableToolModule.run(payload.args, context);

  try {
    writeMessage({
      result,
      type: "result",
    });
  } catch (error) {
    writeMessage({
      error: createSerializedError(error),
      phase: "result",
      type: "error",
    });
  }
}

if (import.meta.main) {
  runLocalToolWorkerProcess()
    .catch((error) => {
      writeMessage({
        error: createSerializedError(error),
        phase: "execution",
        type: "error",
      });
      process.exitCode = 1;
    })
    .finally(() => {
      process.stdout.end();
    });
}
