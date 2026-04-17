import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

describe("backend auto-naming diagnostics", () => {
  let serverProcess: ChildProcess | null = null;
  let userDataDir = "";

  afterEach(async () => {
    if (serverProcess) {
      await stopBackendTestProcess(serverProcess);
      serverProcess = null;
    }

    if (userDataDir) {
      await removeBackendTestScratchDir(userDataDir);
      userDataDir = "";
    }
  });

  test(
    "auto-name failures are replayed through the debug stream when no model is loaded",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-auto-name");
      const applicationPaths = createApplicationPaths(userDataDir);

      await Promise.all([
        mkdir(applicationPaths.mediaDir, { recursive: true }),
        mkdir(applicationPaths.tempDir, { recursive: true }),
        mkdir(applicationPaths.toolsDir, { recursive: true }),
      ]);

      const seedDatabase = new AppDatabase(applicationPaths);
      const chat = seedDatabase.createChat();

      seedDatabase.appendMessage(chat.id, "user", "Summarize my first turn.");
      seedDatabase.appendMessage(chat.id, "assistant", "Here is the first answer.");
      seedDatabase.close();

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats/${chat.id}/auto-name`, {
        method: "POST",
        headers: {
          Origin: backendServer.baseUrl,
        },
      });
      const payload = (await response.json()) as {
        canceled: boolean;
        generated: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.canceled).toBe(true);
      expect(payload.generated).toBe(false);

      const debugText = await readDebugStreamText(
        backendServer.baseUrl,
        (text) =>
          text.includes("Auto-naming could not run") &&
          text.includes("No model is currently loaded."),
      );

      expect(debugText).toContain("Auto-naming could not run");
      expect(debugText).toContain("No model is currently loaded.");
    },
    { timeout: 30_000 },
  );
});

function createApplicationPaths(userDataDir: string): ApplicationPaths {
  return {
    configFilePath: path.join(userDataDir, "config.json"),
    databasePath: path.join(userDataDir, "local-llm-gui.sqlite"),
    mediaDir: path.join(userDataDir, "media"),
    staticOutDir: path.join(userDataDir, "out"),
    tempDir: path.join(userDataDir, "temp"),
    toolsDir: path.join(userDataDir, "tools"),
    userDataDir,
    workspaceRoot: userDataDir,
  };
}

async function startBackendServer(
  port: number,
  userDataDir: string,
): Promise<{ baseUrl: string; process: ChildProcess }> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = {
    stderr: "",
    stdout: "",
  };
  const backendProcess = spawn(
    process.execPath,
    ["src/backend/server.ts", `--port=${port}`, "--dev-proxy"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_LLM_GUI_DISABLE_BROWSER: "1",
        LOCAL_LLM_GUI_FRONTEND_ORIGIN: "http://127.0.0.1:3000",
        LOCAL_LLM_GUI_USER_DATA_DIR: userDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  backendProcess.stdout?.on("data", (chunk: Buffer | string) => {
    output.stdout += chunk.toString();
  });
  backendProcess.stderr?.on("data", (chunk: Buffer | string) => {
    output.stderr += chunk.toString();
  });

  await waitForBackendReady(baseUrl, backendProcess, output);

  return {
    baseUrl,
    process: backendProcess,
  };
}

async function waitForBackendReady(
  baseUrl: string,
  backendProcess: ChildProcess,
  output: { stderr: string; stdout: string },
): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (backendProcess.exitCode !== null) {
      throw new Error(
        [
          `Backend exited before becoming healthy with code ${String(backendProcess.exitCode)}.`,
          output.stdout.trim(),
          output.stderr.trim(),
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      );
    }

    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`);

      if (healthResponse.ok) {
        return;
      }
    } catch {
      // The backend has not started listening yet.
    }

    await delay(100);
  }

  throw new Error(
    [
      `Timed out waiting for the backend to become healthy at ${baseUrl}.`,
      output.stdout.trim(),
      output.stderr.trim(),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
  );
}

async function readDebugStreamText(
  baseUrl: string,
  done: (text: string) => boolean,
): Promise<string> {
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}/api/events/debug`, {
    signal: abortController.signal,
  });
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("The debug SSE response did not provide a readable body.");
  }

  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;

  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        delay(250).then(() => ({ done: false, value: new Uint8Array() })),
      ]);

      if (result.done) {
        break;
      }

      text += decoder.decode(result.value, { stream: true });

      if (done(text)) {
        return text;
      }
    }
  } finally {
    abortController.abort();
    await reader.cancel().catch(() => undefined);
  }

  throw new Error(`Timed out waiting for the debug stream to contain the expected text.\n${text}`);
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probeServer = createServer();

    probeServer.once("error", reject);
    probeServer.listen(0, "127.0.0.1", () => {
      const address = probeServer.address();

      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a local test port."));
        return;
      }

      const resolvedPort = address.port;

      probeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(resolvedPort);
      });
    });
  });
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
